use std::{
    fs::{File, OpenOptions},
    io,
    mem::size_of,
    os::windows::{
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::Path,
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, NtCreateFile,
        },
    },
    Win32::{
        Foundation::{RtlNtStatusToDosError, UNICODE_STRING},
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ, FILE_SHARE_READ, FileAttributeTagInfo,
            GetFileInformationByHandle, GetFileInformationByHandleEx,
        },
        System::IO::IO_STATUS_BLOCK,
    },
};

pub(crate) fn reparse_tag(file: &File) -> io::Result<u32> {
    let mut info = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: file owns the handle and info matches the requested class and size.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            (&raw mut info).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(info.ReparseTag)
}

pub(crate) fn open_root(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

pub(crate) fn open_at(parent: &File, name: &str) -> io::Result<File> {
    let mut name: Vec<u16> = name.encode_utf16().collect();
    let length =
        u16::try_from(name.len() * 2).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: name.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        ..Default::default()
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut handle = std::ptr::null_mut();
    // SAFETY: all input buffers outlive this synchronous call. The name is one
    // validated component, resolved relative to the owned parent handle.
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_GENERIC_READ,
            &attributes,
            &mut status,
            std::ptr::null(),
            0,
            FILE_SHARE_READ,
            FILE_OPEN,
            FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            std::ptr::null(),
            0,
        )
    };
    if result < 0 {
        // SAFETY: this function converts an NTSTATUS value and takes no pointers.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    // SAFETY: NtCreateFile succeeded and transferred a new file handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

pub(crate) fn metadata(path: &Path) -> io::Result<(std::fs::Metadata, (u64, u64))> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: file owns the handle and info is writable for the whole call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let identity = (
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    );
    Ok((file.metadata()?, identity))
}
